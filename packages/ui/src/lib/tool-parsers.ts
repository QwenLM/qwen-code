/**
 * Tool Result Parsers
 *
 * Shared utilities for parsing tool results from agent tools.
 * Used by both Electron and viewer apps for consistent overlay display.
 */

import type { ActivityItem } from '../components/chat/TurnCard'
import type { ToolType } from '../components/terminal/TerminalOutput'

// ============================================================================
// Individual Tool Parsers
// ============================================================================

export interface ReadResult {
  content: string
  numLines?: number
  startLine?: number
  totalLines?: number
}

/**
 * Parse Read tool JSON result to extract file content and metadata.
 */
export function parseReadResult(rawContent: string): ReadResult {
  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.file) {
      return {
        content: parsed.file.content || '',
        numLines: parsed.file.numLines,
        startLine: parsed.file.startLine,
        totalLines: parsed.file.totalLines,
      }
    }
  } catch {
    // Not JSON, use as plain text
  }
  return { content: rawContent }
}

export interface BashResult {
  output: string
  exitCode?: number
}

/**
 * Parse Bash tool JSON result to extract output and exit code.
 */
export function parseBashResult(rawContent: string): BashResult {
  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.stdout !== undefined || parsed.stderr !== undefined) {
      const stdout = parsed.stdout || ''
      const stderr = parsed.stderr || ''
      return {
        output: stdout + (stderr ? `\n${stderr}` : ''),
        exitCode: parsed.interrupted ? 130 : parsed.exitCode,
      }
    }
  } catch {
    // Not JSON, try to extract exit code from text
    const exitMatch = rawContent.match(/Exit code: (\d+)/)
    if (exitMatch && exitMatch[1]) {
      return { output: rawContent, exitCode: parseInt(exitMatch[1], 10) }
    }
  }
  return { output: rawContent }
}

export interface GrepResult {
  output: string
  description: string
  command: string
}

/**
 * Parse Grep tool JSON result to extract search results.
 */
export function parseGrepResult(
  rawContent: string,
  pattern: string,
  searchPath: string,
  outputMode: string
): GrepResult {
  let output = rawContent
  let description = `Search for "${pattern}"`

  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.content !== undefined) {
      output = parsed.content || ''
      if (parsed.numFiles !== undefined) {
        description = `Search for "${pattern}" (${parsed.numFiles} files, ${parsed.numLines || 0} lines)`
      }
    } else if (parsed.filenames) {
      // files_with_matches mode returns filenames array
      output = parsed.filenames.join('\n')
      description = `Search for "${pattern}" (${parsed.filenames.length} files)`
    }
  } catch {
    // Not JSON, use as plain text
  }

  const command = `grep "${pattern}" ${searchPath} --${outputMode}`
  return { output, description, command }
}

export interface GlobResult {
  output: string
  description: string
  command: string
}

/**
 * Parse Glob tool JSON result to extract file list.
 */
export function parseGlobResult(
  rawContent: string,
  pattern: string,
  searchPath: string
): GlobResult {
  let output = rawContent
  let description = `Find files matching "${pattern}"`

  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.filenames && Array.isArray(parsed.filenames)) {
      // Standard Glob result format: { filenames: [...], numFiles, durationMs, truncated }
      output = parsed.filenames.join('\n')
      const truncated = parsed.truncated ? ' (truncated)' : ''
      description = `Find files matching "${pattern}" (${parsed.numFiles || parsed.filenames.length} files${truncated})`
    } else if (Array.isArray(parsed)) {
      // Simple array format
      output = parsed.join('\n')
      description = `Find files matching "${pattern}" (${parsed.length} matches)`
    }
  } catch {
    // Not JSON, use as plain text
  }

  const command = `glob "${pattern}" in ${searchPath}`
  return { output, description, command }
}

/**
 * Parse WebSearch tool result to format embedded JSON links properly.
 * Converts raw JSON arrays in "Links: [...]" to formatted markdown lists.
 * Handles multiple Links sections in a single result.
 */
export function parseWebSearchResult(rawContent: string): string {
  // Find all Links: [...] patterns (may span multiple lines)
  // Use a function replacer to process each match individually
  return rawContent.replace(/Links: (\[[\s\S]*?\])(?=\n|$)/g, (match, jsonArray) => {
    try {
      const links = JSON.parse(jsonArray) as Array<{ title: string; url: string }>

      // Format as markdown list with domain prefix
      const linksList = links.map(link => {
        const domain = new URL(link.url).hostname.replace(/^www\./, '')
        return `- [${domain} - ${link.title}](${link.url})`
      }).join('\n')

      return `**Links:**\n${linksList}`
    } catch {
      // If JSON parsing fails, wrap in code block instead
      return `Links:\n\`\`\`json\n${jsonArray}\n\`\`\``
    }
  })
}

// ============================================================================
// Overlay Data Types
// ============================================================================

export interface CodeOverlayData {
  type: 'code'
  filePath: string
  content: string
  mode: 'read' | 'write'
  startLine?: number
  totalLines?: number
  numLines?: number
  error?: string
  /** Original shell command (for Codex reads) - displayed in overlay */
  command?: string
}

export interface TerminalOverlayData {
  type: 'terminal'
  command: string
  output: string
  exitCode?: number
  toolType: ToolType
  description: string
  error?: string
}

export interface GenericOverlayData {
  type: 'generic'
  content: string
  title: string
  error?: string
}

export interface JSONOverlayData {
  type: 'json'
  data: unknown
  rawContent: string
  title: string
  error?: string
}

/** Rendered markdown document — used for Write tool results on .md/.txt files */
export interface DocumentOverlayData {
  type: 'document'
  content: string
  filePath: string
  /** Tool that produced this content (e.g. "Write") — used for the header type badge */
  toolName: string
  error?: string
}

export type OverlayData = CodeOverlayData | TerminalOverlayData | GenericOverlayData | JSONOverlayData | DocumentOverlayData

/** Generic overlay card model (tab item) for activity details. */
export interface OverlayCard {
  /** Stable card identifier (e.g. input, output, metadata) */
  id: string
  /** Display label shown in card navigator */
  label: string
  /** Card payload rendered by overlay */
  data: OverlayData
  /** Optional CLI-style command preview (shown on Input cards) */
  commandPreview?: string
}

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Extract overlay data from an activity item.
 * Returns typed data for rendering the appropriate overlay component.
 */
export function extractOverlayData(activity: ActivityItem): OverlayData | null {
  if (!activity) return null

  const input = activity.toolInput as Record<string, unknown> | undefined
  const rawContent = activity.content || ''
  const toolName = activity.toolName?.toLowerCase() || ''

  // Get file path from various input formats
  const filePath = (input?.file_path as string) || (input?.path as string) || 'file'

  // Read tool → Code overlay (read mode)
  if (toolName === 'read') {
    const parsed = parseReadResult(rawContent)
    return {
      type: 'code',
      filePath,
      content: parsed.content,
      mode: 'read',
      startLine: parsed.startLine,
      totalLines: parsed.totalLines,
      numLines: parsed.numLines,
      error: activity.error,
      // Pass through command if present (Codex reads via shell commands)
      command: input?._command as string | undefined,
    }
  }

  // Write tool → Document overlay for .md/.txt (rendered markdown), Code overlay for everything else
  if (toolName === 'write') {
    const content = (input?.content as string) || rawContent
    const ext = filePath.split('.').pop()?.toLowerCase()
    if (ext === 'md' || ext === 'txt') {
      return {
        type: 'document',
        filePath,
        content,
        toolName: 'Write',
        error: activity.error,
      }
    }
    return {
      type: 'code',
      filePath,
      content,
      mode: 'write',
      error: activity.error,
    }
  }

  // Edit/Write tools are handled directly by the click handler (multi-diff overlay)
  // so they fall through to the generic handler if they reach here

  // Bash tool → Terminal overlay
  if (toolName === 'bash') {
    const parsed = parseBashResult(rawContent)
    return {
      type: 'terminal',
      command: (input?.command as string) || '',
      output: parsed.output,
      exitCode: parsed.exitCode,
      description: (input?.description as string) || activity.displayName || '',
      toolType: 'bash',
      error: activity.error,
    }
  }

  // Grep tool → Terminal overlay
  if (toolName === 'grep') {
    const pattern = (input?.pattern as string) || ''
    const searchPath = (input?.path as string) || '.'
    const outputMode = (input?.output_mode as string) || 'files_with_matches'
    const parsed = parseGrepResult(rawContent, pattern, searchPath, outputMode)
    return {
      type: 'terminal',
      command: parsed.command,
      output: parsed.output,
      description: parsed.description,
      toolType: 'grep',
      error: activity.error,
    }
  }

  // Glob tool → Terminal overlay
  if (toolName === 'glob') {
    const pattern = (input?.pattern as string) || '*'
    const searchPath = (input?.path as string) || '.'
    const parsed = parseGlobResult(rawContent, pattern, searchPath)
    return {
      type: 'terminal',
      command: parsed.command,
      output: parsed.output,
      description: parsed.description,
      toolType: 'glob',
      error: activity.error,
    }
  }

  // WebSearch tool → Document overlay with formatted links
  if (toolName === 'websearch') {
    const formattedContent = parseWebSearchResult(rawContent)
    return {
      type: 'document',
      filePath: 'Web Search Results',
      content: formattedContent,
      toolName: 'WebSearch',
      error: activity.error,
    }
  }

  // LLM Query tool (call_llm) → Document overlay with input prompt + output response
  if (toolName === 'mcp__session__call_llm') {
    const prompt = (input?.prompt as string) || ''
    const model = input?.model as string | undefined
    const systemPrompt = input?.systemPrompt as string | undefined
    const attachments = input?.attachments as unknown[] | undefined
    const outputFormat = input?.outputFormat as string | undefined
    const outputSchema = input?.outputSchema as Record<string, unknown> | undefined

    const sections: string[] = []

    // Input section
    sections.push('## Prompt')

    // Metadata (only show when present)
    const meta: string[] = []
    if (model) meta.push(`**Model:** ${model}`)
    if (systemPrompt) meta.push(`**System Prompt:** ${systemPrompt}`)
    if (outputFormat) meta.push(`**Output Format:** ${outputFormat}`)
    if (outputSchema) meta.push(`**Output Schema:**\n\`\`\`json\n${JSON.stringify(outputSchema, null, 2)}\n\`\`\``)
    if (attachments && attachments.length > 0) {
      const paths = attachments
        .map(a => typeof a === 'string' ? a : (a as { path: string }).path)
        .filter(Boolean)
      if (paths.length > 0) meta.push(`**Attachments:** ${paths.join(', ')}`)
    }
    if (meta.length > 0) {
      sections.push(meta.join('\n\n'))
    }

    sections.push(prompt)

    // Output section
    if (rawContent) {
      sections.push('---')
      sections.push('## Response')
      sections.push(rawContent)
    }

    return {
      type: 'document',
      content: sections.join('\n\n'),
      filePath: 'LLM Query',
      toolName: 'call_llm',
      error: activity.error,
    }
  }

  // Try to detect JSON content for unknown tools (MCP tools, WebFetch, etc.)
  // JSON objects/arrays get interactive tree viewer, other content falls through to generic
  const trimmedContent = rawContent.trim()
  if ((trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) ||
      (trimmedContent.startsWith('[') && trimmedContent.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmedContent)
      return {
        type: 'json',
        data: parsed,
        rawContent: trimmedContent,
        title: activity.displayName || activity.toolName || 'JSON Result',
        error: activity.error,
      }
    } catch {
      // Not valid JSON, fall through to generic
    }
  }

  // Fallback for unknown tools - plain text/markdown content
  return {
    type: 'generic',
    content: rawContent || (input ? JSON.stringify(input, null, 2) : ''),
    title: activity.displayName || activity.toolName || 'Activity',
    error: activity.error,
  }
}

function normalizeToolCommandName(toolName?: string): string {
  const raw = toolName || 'tool'
  if (raw.startsWith('mcp__session__')) return raw.slice('mcp__session__'.length)
  if (raw.startsWith('mcp__workspace__')) return raw.slice('mcp__workspace__'.length)
  return raw
}

function formatCliValue(value: unknown): string {
  if (typeof value === 'string') {
    const needsQuoting = /\s|"|\\/.test(value)
    if (!needsQuoting) return value
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return JSON.stringify(value)
}

/** Build a deterministic, Bash-like command preview from tool name + input. */
export function formatToolCommandPreview(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolName) return undefined
  const normalized = normalizeToolCommandName(toolName)

  if (!input || Object.keys(input).length === 0) {
    return normalized
  }

  // Wrapper commands pass through the raw CLI input for best fidelity.
  if (normalized === 'browser_tool' && typeof input.command === 'string' && input.command.trim()) {
    return input.command.trim()
  }

  const entries = Object.entries(input)
    .filter(([key, value]) => key !== '_intent' && key !== '_displayName' && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))

  const flags = entries.map(([key, value]) => {
    if (typeof value === 'boolean') return value ? `--${key}` : `--${key} false`
    return `--${key} ${formatCliValue(value)}`
  })

  return flags.length > 0 ? `${normalized} ${flags.join(' ')}` : normalized
}

/**
 * Extract one or more overlay cards from an activity.
 *
 * Current cards:
 * - Input: toolInput (when present)
 * - Output: parsed tool result/content (when meaningful)
 *
 * This intentionally returns an array to support future card types
 * without changing the overlay contract.
 */
export function extractOverlayCards(activity: ActivityItem): OverlayCard[] {
  if (!activity) return []

  const cards: OverlayCard[] = []
  const input = activity.toolInput as Record<string, unknown> | undefined
  const hasInput = !!input && Object.keys(input).length > 0

  // Input card (JSON-first, generic fallback)
  let inputJson = ''
  const commandPreview = formatToolCommandPreview(activity.toolName, input)
  if (hasInput) {
    try {
      inputJson = JSON.stringify(input, null, 2)
      cards.push({
        id: 'input',
        label: 'Input',
        commandPreview,
        data: {
          type: 'json',
          data: input,
          rawContent: inputJson,
          title: `${activity.displayName || activity.toolName || 'Tool'} Input`,
        },
      })
    } catch {
      cards.push({
        id: 'input',
        label: 'Input',
        commandPreview,
        data: {
          type: 'generic',
          content: String(input),
          title: `${activity.displayName || activity.toolName || 'Tool'} Input`,
        },
      })
    }
  }

  // Output card (always present for consistent Input/Output UX)
  const output = extractOverlayData(activity)
  const rawContent = (activity.content || '').trim()
  const isInputMirrorFallback =
    hasInput &&
    rawContent.length === 0 &&
    output?.type === 'generic' &&
    !!inputJson &&
    output.content.trim() === inputJson.trim()

  const outputData: OverlayData = isInputMirrorFallback
    ? {
        type: 'generic',
        content: 'No output captured for this tool call.',
        title: `${activity.displayName || activity.toolName || 'Tool'} Output`,
        error: activity.error,
      }
    : (output || {
      type: 'generic',
      content: rawContent || 'No output captured for this tool call.',
      title: `${activity.displayName || activity.toolName || 'Tool'} Output`,
      error: activity.error,
    })

  cards.push({
    id: 'output',
    label: 'Output',
    data: outputData,
  })

  // Last-resort fallback (kept for defensive safety)
  if (cards.length === 0) {
    cards.push({
      id: 'output',
      label: 'Output',
      data: {
        type: 'generic',
        content: 'No output captured for this tool call.',
        title: activity.displayName || activity.toolName || 'Activity',
        error: activity.error,
      },
    })
  }

  return cards
}
