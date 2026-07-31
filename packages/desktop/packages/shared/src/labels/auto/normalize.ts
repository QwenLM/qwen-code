/**
 * Auto-Label Value Normalization
 *
 * Normalizes raw extracted values based on the label's valueType.
 * Called after regex capture groups are substituted into the valueTemplate.
 *
 * Normalization rules:
 * - string: pass-through (no transformation)
 * - number: strip commas, expand suffixes (k/K → ×1000, M → ×1000000)
 * - date: pass-through (regex captures already produce ISO format)
 */

/**
 * Normalize a raw extracted value based on the target label's valueType.
 * Returns the normalized string ready for storage in the session label entry.
 *
 * @param raw - Raw value string from regex valueTemplate substitution
 * @param valueType - The label's declared valueType (determines normalization strategy)
 */
export function normalizeValue(raw: string, valueType?: 'string' | 'number' | 'date'): string {
  switch (valueType) {
    case 'number':
      return normalizeNumber(raw)
    case 'date':
      // Date values from regex capture are expected to already be in ISO format
      return raw
    case 'string':
    default:
      return raw
  }
}

/**
 * Normalize a number string:
 * - Strip commas (thousands separators): "45,000" → "45000"
 * - Strip leading currency symbols: "$45000" → "45000"
 * - Expand k/K suffix: "45k" → "45000"
 * - Expand M suffix: "1.5M" → "1500000"
 * - Expand B suffix: "2B" → "2000000000"
 */
function normalizeNumber(raw: string): string {
  // Strip leading currency symbols
  let cleaned = raw.replace(/^[$€£¥]/, '')

  // Strip commas
  cleaned = cleaned.replace(/,/g, '')

  // Expand suffixes (case-insensitive)
  const suffixMatch = cleaned.match(/^(-?\d+\.?\d*)\s*([kKmMbB])$/)
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1]!)
    const suffix = suffixMatch[2]!.toLowerCase()
    const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1_000_000_000
    const result = num * multiplier
    // Avoid floating point artifacts: use integer if whole number
    return Number.isInteger(result) ? result.toString() : result.toFixed(2)
  }

  // Try to parse as a plain number (validates it's actually numeric)
  const parsed = parseFloat(cleaned)
  if (!isNaN(parsed) && isFinite(parsed)) {
    return Number.isInteger(parsed) ? parsed.toString() : parsed.toString()
  }

  // Fallback: return cleaned string if it doesn't parse as a number
  return cleaned
}
