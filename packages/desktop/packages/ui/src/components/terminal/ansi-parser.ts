/**
 * ANSI escape code parsing utilities for terminal output.
 */

/**
 * ANSI color code to CSS color mapping
 * Supports both foreground (30-37, 90-97) and background (40-47, 100-107) colors
 */
export const ANSI_COLORS: Record<number, string> = {
  // Standard foreground colors (30-37)
  30: '#1a1a1a', // Black
  31: '#ef4444', // Red
  32: '#22c55e', // Green
  33: '#eab308', // Yellow
  34: '#3b82f6', // Blue
  35: '#a855f7', // Magenta
  36: '#06b6d4', // Cyan
  37: '#e4e4e4', // White
  // Bright foreground colors (90-97)
  90: '#666666', // Bright Black (Gray)
  91: '#f87171', // Bright Red
  92: '#4ade80', // Bright Green
  93: '#facc15', // Bright Yellow
  94: '#60a5fa', // Bright Blue
  95: '#c084fc', // Bright Magenta
  96: '#22d3ee', // Bright Cyan
  97: '#ffffff', // Bright White
  // Standard background colors (40-47)
  40: '#1a1a1a', // Black
  41: '#ef4444', // Red
  42: '#22c55e', // Green
  43: '#eab308', // Yellow
  44: '#3b82f6', // Blue
  45: '#a855f7', // Magenta
  46: '#06b6d4', // Cyan
  47: '#e4e4e4', // White
  // Bright background colors (100-107)
  100: '#666666',
  101: '#f87171',
  102: '#4ade80',
  103: '#facc15',
  104: '#60a5fa',
  105: '#c084fc',
  106: '#22d3ee',
  107: '#ffffff',
}

export interface AnsiSpan {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
}

/**
 * Parse ANSI escape codes and convert to styled spans
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const result: AnsiSpan[] = []
  // Match ANSI escape sequences: ESC[...m
  const regex = /\x1b\[([0-9;]*)m/g
  let lastIndex = 0
  let currentFg: string | undefined
  let currentBg: string | undefined
  let currentBold = false

  let match
  while ((match = regex.exec(input)) !== null) {
    // Add text before this escape sequence
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index)
      if (text) {
        result.push({ text, fg: currentFg, bg: currentBg, bold: currentBold })
      }
    }

    // Parse the SGR codes
    const codes = (match[1] || '').split(';').map(c => parseInt(c, 10) || 0)
    for (const code of codes) {
      if (code === 0) {
        // Reset
        currentFg = undefined
        currentBg = undefined
        currentBold = false
      } else if (code === 1) {
        // Bold
        currentBold = true
      } else if (code === 39) {
        // Default foreground
        currentFg = undefined
      } else if (code === 49) {
        // Default background
        currentBg = undefined
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        // Foreground color
        currentFg = ANSI_COLORS[code]
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        // Background color
        currentBg = ANSI_COLORS[code]
      }
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < input.length) {
    const text = input.slice(lastIndex)
    if (text) {
      result.push({ text, fg: currentFg, bg: currentBg, bold: currentBold })
    }
  }

  return result
}

/**
 * Strip ANSI escape codes from text (for copying)
 */
export function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Check if output looks like grep content output (with line numbers)
 * Pattern: starts with lines like "123:" (match) or "123-" (context)
 */
export function isGrepContentOutput(output: string): boolean {
  const lines = output.split('\n').slice(0, 5) // Check first 5 lines
  return lines.some(line => /^\d+[:\-]/.test(line))
}

export interface GrepLine {
  lineNum: string
  isMatch: boolean
  content: string
}

/**
 * Parse grep content output into structured lines
 */
export function parseGrepOutput(output: string): GrepLine[] {
  return output.split('\n').map(line => {
    const match = line.match(/^(\d+)([:])(.*)$/)
    const context = line.match(/^(\d+)(-)(.*)$/)
    if (match && match[1] && match[3] !== undefined) {
      return { lineNum: match[1], isMatch: true, content: match[3] }
    } else if (context && context[1] && context[3] !== undefined) {
      return { lineNum: context[1], isMatch: false, content: context[3] }
    }
    return { lineNum: '', isMatch: false, content: line }
  })
}
