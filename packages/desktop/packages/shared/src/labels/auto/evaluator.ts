/**
 * Auto-Label Evaluator
 *
 * Core evaluation engine for auto-label rules. Scans user messages against
 * configured regex patterns, producing label matches.
 *
 * Evaluation flow:
 * 1. Strip code blocks from message (avoid matching inside code)
 * 2. Walk the label tree, collect all labels with autoRules
 * 3. For each rule: run regex with forced 'g' flag, substitute capture groups
 * 4. Normalize extracted values based on the label's valueType
 * 5. Deduplicate matches (same labelId + value = keep only first)
 * 6. Cap at MAX_MATCHES_PER_MESSAGE to prevent label explosion
 * 7. Return array of AutoLabelMatch ready for session storage
 */

import type { LabelConfig, AutoLabelRule } from '../types.ts'
import type { AutoLabelMatch } from './types.ts'
import { normalizeValue } from './normalize.ts'

/** Maximum number of auto-label matches per message to prevent label explosion from pasted logs/data */
const MAX_MATCHES_PER_MESSAGE = 10

/**
 * Recursively collect all labels that have autoRules defined.
 * Walks the entire label tree depth-first.
 */
export function collectAutoLabelRules(labels: LabelConfig[]): Array<{
  label: LabelConfig
  rule: AutoLabelRule
}> {
  const result: Array<{ label: LabelConfig; rule: AutoLabelRule }> = []

  function walk(nodes: LabelConfig[]) {
    for (const label of nodes) {
      if (label.autoRules) {
        for (const rule of label.autoRules) {
          result.push({ label, rule })
        }
      }
      if (label.children) {
        walk(label.children)
      }
    }
  }

  walk(labels)
  return result
}

/**
 * Strip fenced code blocks and inline code from message text.
 * Prevents regex patterns from matching inside code examples, logs, etc.
 */
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')  // fenced code blocks
    .replace(/`[^`]+`/g, '')          // inline code
}

/**
 * Evaluate all auto-label rules against a user message.
 * Returns deduplicated matches with normalized values, capped at MAX_MATCHES_PER_MESSAGE.
 *
 * @param message - The user's message text to scan
 * @param labels - The workspace label tree (from config)
 */
export function evaluateAutoLabels(
  message: string,
  labels: LabelConfig[],
): AutoLabelMatch[] {
  // Strip code blocks before scanning to avoid matching inside code
  const cleanMessage = stripCodeBlocks(message)

  const rules = collectAutoLabelRules(labels)
  const matches: AutoLabelMatch[] = []
  // Track seen entries to deduplicate (same label + same value = skip)
  const seen = new Set<string>()

  for (const { label, rule } of rules) {
    // Stop if we've hit the match limit
    if (matches.length >= MAX_MATCHES_PER_MESSAGE) break

    const ruleMatches = evaluateRegexRule(cleanMessage, label, rule)

    // Deduplicate and add to results (respecting match limit)
    for (const match of ruleMatches) {
      if (matches.length >= MAX_MATCHES_PER_MESSAGE) break

      const key = `${match.labelId}::${match.value}`
      if (!seen.has(key)) {
        seen.add(key)
        matches.push(match)
      }
    }
  }

  return matches
}

/**
 * Evaluate a regex-based auto-label rule.
 * Always enforces the 'g' flag to prevent infinite exec() loops.
 * Uses single-pass $N substitution to prevent injection.
 */
function evaluateRegexRule(
  message: string,
  label: LabelConfig,
  rule: AutoLabelRule
): AutoLabelMatch[] {
  const matches: AutoLabelMatch[] = []

  try {
    // Ensure global flag is always present to prevent infinite exec() loops
    const flags = rule.flags
      ? (rule.flags.includes('g') ? rule.flags : rule.flags + 'g')
      : 'gi'
    const regex = new RegExp(rule.pattern, flags)
    let match: RegExpExecArray | null

    while ((match = regex.exec(message)) !== null) {
      // Single-pass $N substitution: prevents injection where captured text
      // contains $N patterns that would be double-substituted
      let value = rule.valueTemplate
        ? rule.valueTemplate.replace(/\$(\d+)/g, (_, n) => match![parseInt(n)] ?? '')
        : match[1] ?? match[0]

      // Normalize based on the label's declared valueType
      value = normalizeValue(value, label.valueType)

      matches.push({
        labelId: label.id,
        value,
        matchedText: match[0],
      })

      // Prevent infinite loop on zero-length matches
      if (match[0].length === 0) {
        regex.lastIndex++
      }
    }
  } catch (e) {
    // Invalid regex — skip silently (validation should catch this at config time)
    console.warn(`[AutoLabel] Invalid regex for label "${label.id}": ${rule.pattern}`, e)
  }

  return matches
}
