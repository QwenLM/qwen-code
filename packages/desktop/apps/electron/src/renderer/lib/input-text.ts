/**
 * Coerce untrusted composer/draft values into plain text.
 *
 * The renderer normally stores draft text as a string, but installed builds can
 * encounter stale or malformed persisted values (for example an entire draft
 * object, or an object in the `text` field). Keep input call sites defensive so
 * `.trim()` and rich-text rendering never receive a non-string value.
 */
export function coerceInputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof String) return value.toString()

  if (typeof value === 'object') {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
  }

  return ''
}
