/**
 * MarkdownJsonBlock - Interactive JSON tree viewer for markdown code blocks
 *
 * When the markdown viewer encounters a ```json code block, this component
 * renders it with the same @uiw/react-json-view setup and styling used in
 * JSONPreviewOverlay, instead of static Shiki syntax highlighting.
 *
 * - Parses the raw code string as JSON
 * - Recursively expands stringified-JSON-within-JSON (deepParseJson)
 * - Uses craft themes (transparent bg, CSS variable fonts)
 * - Defaults to collapsed={2} for inline chat context
 * - Falls back to CodeBlock if JSON parsing or rendering fails
 */

import * as React from 'react'
import JsonView from '@uiw/react-json-view'
import { vscodeTheme } from '@uiw/react-json-view/vscode'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import { Copy, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'

// ── Themes (same as JSONPreviewOverlay) ────────────────────────────────────
// Transparent background so the container's bg-muted/30 shows through,
// and CSS variable font so it matches the app's monospace font.

const craftAgentDarkTheme = {
  ...vscodeTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

const craftAgentLightTheme = {
  ...githubLightTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

// ── Deep parse helper (same as JSONPreviewOverlay) ─────────────────────────
// Recursively parse stringified JSON within JSON values so nested objects
// like {"result": "{\"nested\": \"value\"}"} display as expandable nodes.

function deepParseJson(value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return deepParseJson(JSON.parse(trimmed))
      } catch {
        return value
      }
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map(deepParseJson)
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepParseJson(val)
    }
    return result
  }

  return value
}

// ── Error boundary ────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Lightweight error boundary so a JsonView failure doesn't crash the whole
 * message — we fall back to the regular CodeBlock instead.
 */
class JsonErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.warn('[MarkdownJsonBlock] JsonView render failed, falling back to CodeBlock:', error)
  }

  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isDarkMode(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

// ── Main component ────────────────────────────────────────────────────────

export interface MarkdownJsonBlockProps {
  /** Raw JSON string from the markdown code block */
  code: string
  className?: string
}

export function MarkdownJsonBlock({ code, className }: MarkdownJsonBlockProps) {
  const [copied, setCopied] = React.useState(false)

  // Try to parse – fall back to syntax-highlighted CodeBlock if invalid JSON
  const parsed = React.useMemo(() => {
    try {
      const raw = JSON.parse(code)
      return deepParseJson(raw) as object
    } catch {
      return null
    }
  }, [code])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy JSON:', err)
    }
  }, [code])

  if (parsed === null) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const dark = isDarkMode()
  const jsonTheme = dark ? craftAgentDarkTheme : craftAgentLightTheme
  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  return (
    <JsonErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/30', className)}>
        {/* Header — matches CodeBlock full mode (label + copy on hover) */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b text-xs">
          <span className="text-muted-foreground font-medium uppercase tracking-wide">json</span>
          <button
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
            aria-label="Copy JSON"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* Interactive tree viewer */}
        <div className="p-3 overflow-x-auto text-sm">
          <JsonView
            value={parsed}
            style={jsonTheme}
            collapsed={2}
            enableClipboard={true}
            displayDataTypes={false}
            shortenTextAfterLength={100}
          >
            {/* Custom copy icon — same as JSONPreviewOverlay */}
            <JsonView.Copied
              render={(props) => {
                const isCopied = (props as Record<string, unknown>)['data-copied']
                return isCopied ? (
                  <Check
                    className="ml-1.5 inline-flex cursor-pointer text-green-500"
                    size={10}
                    onClick={props.onClick}
                  />
                ) : (
                  <Copy
                    className="ml-1.5 inline-flex cursor-pointer text-muted-foreground hover:text-foreground"
                    size={10}
                    onClick={props.onClick}
                  />
                )
              }}
            />
          </JsonView>
        </div>
      </div>
    </JsonErrorBoundary>
  )
}
