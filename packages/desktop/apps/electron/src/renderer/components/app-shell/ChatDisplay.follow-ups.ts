/**
 * Pure helpers for follow-up annotations.
 *
 * Kept separate from `ChatDisplay.tsx` so they can be unit-tested without
 * pulling in React or the rest of the renderer. `ChatDisplay.tsx`
 * re-imports these — do not duplicate the logic there.
 *
 * Two distinct transforms live here:
 *   - `normalizeFollowUpText` (re-exported from `@craft-agent/ui`) — the
 *     content-preserving whitespace collapse used for the agent-facing
 *     message. NO length cap.
 *   - `truncateForChipTooltip` — UI helper that shortens + ellipsizes for
 *     the hover tooltip on the chip's index badge. Caller MUST supply the
 *     cap — there is no sensible default, and a default was the root
 *     cause of a past bug (OSS #580) where the agent-facing path
 *     accidentally reused it.
 */

import { normalizeFollowUpText } from '@craft-agent/ui/annotations/follow-up-state'

export type PendingFollowUpAnnotation = {
  messageId: string
  annotationId: string
  note: string
  selectedText: string
  createdAt: number
  color?: string
  meta?: Record<string, unknown>
}

/**
 * Whitespace-normalize + truncate for the hover tooltip shown on the
 * chip's index badge. Do NOT use for agent-facing messages — use
 * `normalizeFollowUpText` directly so the agent sees the full quote.
 */
export function truncateForChipTooltip(text: string, maxLength: number): string {
  const normalized = normalizeFollowUpText(text)
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

/**
 * Format pending follow-up annotations as a markdown section appended to
 * the user's message before it is sent to the agent. Quotes pass through
 * in full — only whitespace is normalized so the round-trip parser
 * (`normalizeFollowUpsMarkdown`) can re-parse them on message edit.
 */
export function formatFollowUpSection(
  followUps: PendingFollowUpAnnotation[],
  options?: { includeTopSeparator?: boolean },
): string {
  if (followUps.length === 0) return ''

  const includeTopSeparator = options?.includeTopSeparator ?? true

  const items = followUps.map((followUp, idx) => {
    const quoteText = normalizeFollowUpText(followUp.selectedText)
    return [
      `> [#${idx + 1}] ${quoteText}`,
      `→ ${followUp.note}`,
    ].join('\n')
  })

  const body = ['**Follow-ups**', items.join('\n\n---\n\n')].join('\n\n')
  return includeTopSeparator ? `---\n\n${body}` : body
}

/**
 * Re-parse a message that already contains a `**Follow-ups**` section and
 * rebuild it in canonical form. Used when the user edits a sent message —
 * we want to normalize whitespace / re-number / repair spacing without
 * losing the quote/note pairs.
 *
 * The regex uses lazy `[\s\S]*?` for quotes, so arbitrarily long quotes
 * are handled correctly. Whitespace in quotes/notes is collapsed, matching
 * what `normalizeFollowUpText` produces — so a round-trip is a no-op for
 * quotes that passed through `formatFollowUpSection`.
 */
export function normalizeFollowUpsMarkdown(message: string): string {
  const normalizedInput = message.replace(/\r\n/g, '\n')
  const headingMatch = /(?:\*\*Follow-ups\*\*|Follow-up annotations:)/i.exec(normalizedInput)
  if (!headingMatch || headingMatch.index == null) return message

  const headingIndex = headingMatch.index
  const beforeHeading = normalizedInput.slice(0, headingIndex).trimEnd()
  const hasTrailingSeparator = /(?:^|\n)\s*---\s*$/.test(beforeHeading)
  const sectionText = normalizedInput.slice(headingIndex)

  // Remove heading and optional leading separator so we can parse items robustly.
  const body = sectionText
    .replace(/^\s*(?:---\s*)?(?:\*\*Follow-ups\*\*|Follow-up annotations:)\s*/i, '')

  const itemRegex = />?\s*\[#(\d+)\]\s*([\s\S]*?)\s*→\s*([\s\S]*?)(?=(?:\s*---\s*>?\s*\[#\d+\])|$)/g
  const parsedItems: Array<{ quote: string; note: string }> = []

  for (const match of body.matchAll(itemRegex)) {
    const quote = match[2]?.replace(/\s+/g, ' ').trim()
    const note = match[3]?.replace(/\s+/g, ' ').trim()
    if (!quote || !note) continue
    parsedItems.push({ quote, note })
  }

  if (parsedItems.length === 0) {
    return message
  }

  const rebuiltItems = parsedItems.map((item, idx) => [
    `> [#${idx + 1}] ${item.quote}`,
    `→ ${item.note}`,
  ].join('\n'))

  const includeTopSeparator = beforeHeading.length > 0 && !hasTrailingSeparator
  const rebuiltBody = ['**Follow-ups**', rebuiltItems.join('\n\n---\n\n')].join('\n\n')
  const rebuiltSection = includeTopSeparator
    ? `---\n\n${rebuiltBody}`
    : rebuiltBody

  return beforeHeading.length > 0 ? `${beforeHeading}\n\n${rebuiltSection}` : rebuiltSection
}
