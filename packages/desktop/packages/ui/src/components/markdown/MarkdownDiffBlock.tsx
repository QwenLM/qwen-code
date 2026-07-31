/**
 * MarkdownDiffBlock - Renders diff code blocks using @pierre/diffs
 *
 * When the markdown viewer encounters a ```diff code block, this component
 * renders it with the same pierre/diffs setup (PatchDiff) and styling used
 * in the full-screen diff overlay (ShikiDiffViewer), instead of plain
 * Shiki syntax highlighting.
 *
 * Handles common diff code block formats:
 * 1. Proper unified diffs (with --- / +++ / @@ headers) — passed directly
 * 2. Numbered hunks without file headers — synthetic file headers are prepended
 * 3. Bare diff content or bare @@ markers — synthetic headers are prepended
 *
 * Falls back to the regular CodeBlock if PatchDiff rendering fails.
 */

import * as React from 'react'
import { PatchDiff, type PatchDiffProps } from '@pierre/diffs/react'
import { DIFFS_TAG_NAME } from '@pierre/diffs'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { ensureUnifiedDiffFormat } from './diff-normalize'
import { registerCraftShikiThemes } from '../code-viewer/registerShikiThemes'

// ── Custom element + theme registration (same as ShikiDiffViewer) ──────────
// Idempotent: safe to run even if ShikiDiffViewer already registered these.

if (typeof HTMLElement !== 'undefined' && !customElements.get(DIFFS_TAG_NAME)) {
  class FileDiffContainer extends HTMLElement {
    constructor() {
      super()
      if (this.shadowRoot != null) return
      this.attachShadow({ mode: 'open' })
    }
  }
  customElements.define(DIFFS_TAG_NAME, FileDiffContainer)
}

// Register custom themes once per runtime.
registerCraftShikiThemes()

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Detect whether we're in dark mode by checking the DOM class list.
 * Mirrors the fallback logic in CodeBlock.
 */
function isDarkMode(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

// ── Error boundary ────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Lightweight error boundary so a PatchDiff failure doesn't crash the whole
 * message — we fall back to the regular CodeBlock instead.
 */
class DiffErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.warn('[MarkdownDiffBlock] PatchDiff render failed, falling back to CodeBlock:', error)
  }

  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Main component ────────────────────────────────────────────────────────

export interface MarkdownDiffBlockProps {
  /** Raw diff text from the markdown code block */
  code: string
  className?: string
}

export function MarkdownDiffBlock({ code, className }: MarkdownDiffBlockProps) {
  const dark = isDarkMode()
  const themeName = dark ? 'craft-dark' : 'craft-light'

  // Build the same options used in ShikiDiffViewer for visual consistency
  const options: PatchDiffProps<undefined>['options'] = React.useMemo(() => ({
    theme: themeName,
    diffStyle: 'unified' as const,
    diffIndicators: 'bars' as const,
    disableBackground: false,
    lineDiffType: 'word' as const,
    overflow: 'scroll' as const,
    disableFileHeader: true,
    themeType: dark ? ('dark' as const) : ('light' as const),
  }), [themeName, dark])

  const patch = React.useMemo(() => ensureUnifiedDiffFormat(code), [code])

  const fallback = <CodeBlock code={code} language="diff" mode="full" className={className} />

  return (
    <DiffErrorBoundary fallback={fallback}>
      <div
        className={cn(
          'relative rounded-[8px] overflow-hidden border bg-muted/30',
          className,
        )}
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <PatchDiff patch={patch} options={options} />
      </div>
    </DiffErrorBoundary>
  )
}
