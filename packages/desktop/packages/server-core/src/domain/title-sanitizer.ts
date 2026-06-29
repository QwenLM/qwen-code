/**
 * Title sanitization utility.
 * Extracted to a separate file to allow unit testing without importing
 * Electron main process modules.
 */
import { WS_ID_CHARS } from '@craft-agent/shared/mentions'

/**
 * Sanitize message content for use as session title.
 * Strips XML blocks (e.g. <edit_request>), bracket mentions, and normalizes whitespace.
 */
export function sanitizeForTitle(content: string): string {
  return content
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '') // Strip entire edit_request blocks
    .replace(/<[^>]+>/g, '')     // Strip remaining XML/HTML tags
    .replace(new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?[\\w-]+\\]`, 'g'), '')   // Strip [skill:...] mentions
    .replace(/\[source:[\w-]+\]/g, '')                // Strip [source:...] mentions
    .replace(/\[file:[^\]]+\]/g, '')                  // Strip [file:...] mentions
    .replace(/\[folder:[^\]]+\]/g, '')                // Strip [folder:...] mentions
    .replace(/\s+/g, ' ')        // Collapse whitespace
    .trim()
}
