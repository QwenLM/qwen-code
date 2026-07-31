/**
 * Markdown → Telegram MarkdownV2 formatting.
 *
 * Telegram MarkdownV2 requires escaping special characters outside of
 * code blocks. For Phase 1 we send plain text — formatting added in Phase 2.
 */

/** Characters that must be escaped in Telegram MarkdownV2. */
const TG_SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g

/** Escape text for Telegram MarkdownV2 parse mode. */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(TG_SPECIAL_CHARS, '\\$1')
}

/**
 * For Phase 1 we send plain text (no parse_mode).
 * This avoids escaping issues while we validate the core flow.
 */
export function formatForTelegram(text: string): string {
  return text
}
