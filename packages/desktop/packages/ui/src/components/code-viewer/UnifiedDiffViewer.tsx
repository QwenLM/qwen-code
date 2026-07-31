/**
 * UnifiedDiffViewer - Diff viewer for pre-computed unified diff strings
 *
 * Used for Codex file operations which provide unified diff patches
 * instead of original/modified content strings.
 *
 * Uses @pierre/diffs parsePatchFiles to parse the unified diff string
 * and renders via the FileDiff component with proper theming.
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { FileDiff, type FileDiffProps } from '@pierre/diffs/react'
import { parsePatchFiles, DIFFS_TAG_NAME, registerCustomTheme, resolveTheme, type FileDiffMetadata } from '@pierre/diffs'
import { cn } from '../../lib/utils'
import { LANGUAGE_MAP } from './language-map'

// Register the diffs-container custom element if not already registered
// (shared with ShikiDiffViewer - safe to call multiple times)
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

// Custom themes are registered in ShikiDiffViewer and shared across components

export interface UnifiedDiffViewerProps {
  /** Raw unified diff string (e.g., from Codex fileChange.diff) */
  unifiedDiff: string
  /** File path - used for display in header */
  filePath?: string
  /** Diff style: 'unified' (stacked) or 'split' (side-by-side) */
  diffStyle?: 'unified' | 'split'
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Shiki theme name (e.g., 'dracula', 'github-dark'). When provided, uses the matching
   *  Shiki theme natively. Falls back to craft-dark/craft-light (transparent bg) if not set. */
  shikiTheme?: string
  /** Disable background highlighting on changed lines */
  disableBackground?: boolean
  /** Whether to hide pierre's native file header (filename + stats). Default: true */
  disableFileHeader?: boolean
  /** Callback when the file header is clicked (e.g. to open the file in an editor).
   *  When provided, the header becomes clickable with cursor: pointer. */
  onFileHeaderClick?: (filePath: string) => void
  /** Callback when ready */
  onReady?: () => void
  /** Additional class names */
  className?: string
}

/**
 * Parse a unified diff string into FileDiffMetadata.
 * Handles edge cases like empty diffs or malformed patches.
 */
function parseUnifiedDiff(unifiedDiff: string, filePath: string): FileDiffMetadata | null {
  if (!unifiedDiff || !unifiedDiff.trim()) {
    return null
  }

  try {
    // parsePatchFiles expects a complete patch format
    // If the diff doesn't have a proper header, we might need to add one
    let patchContent = unifiedDiff

    // Check if it's a raw hunk without file headers
    // A proper unified diff starts with "---" or "diff --git"
    if (!patchContent.startsWith('---') && !patchContent.startsWith('diff ')) {
      // Wrap in minimal unified diff format
      patchContent = `--- a/${filePath}\n+++ b/${filePath}\n${patchContent}`
    }

    const patches = parsePatchFiles(patchContent)
    const firstPatch = patches[0]
    if (firstPatch && firstPatch.files.length > 0) {
      const firstFile = firstPatch.files[0]
      return firstFile ?? null
    }
    return null
  } catch (e) {
    console.warn('[UnifiedDiffViewer] Failed to parse unified diff:', e)
    return null
  }
}

/**
 * UnifiedDiffViewer - Renders pre-computed unified diff strings
 */
export function UnifiedDiffViewer({
  unifiedDiff,
  filePath = 'file',
  diffStyle = 'unified',
  theme = 'light',
  shikiTheme,
  disableBackground = false,
  disableFileHeader = true,
  onFileHeaderClick,
  onReady,
  className,
}: UnifiedDiffViewerProps) {
  const hasCalledReady = useRef(false)
  const [isReady, setIsReady] = useState(false)

  // Parse the unified diff
  const fileDiff = useMemo(() => {
    return parseUnifiedDiff(unifiedDiff, filePath)
  }, [unifiedDiff, filePath])

  // Diff options - use the app's Shiki theme if available, otherwise fall back
  // to craft-dark/craft-light which have transparent bg for CSS variable theming
  const resolvedThemeName = shikiTheme || (theme === 'dark' ? 'craft-dark' : 'craft-light')

  // When onFileHeaderClick is provided, inject CSS to make the header look clickable
  const unsafeCSS = onFileHeaderClick
    ? '[data-diffs-header] { cursor: pointer; } [data-diffs-header]:hover [data-title] { text-decoration: underline; }'
    : undefined

  const options: FileDiffProps<undefined>['options'] = useMemo(() => ({
    theme: resolvedThemeName,
    diffStyle,
    diffIndicators: 'bars',
    disableBackground,
    lineDiffType: 'word',
    overflow: 'scroll',
    disableFileHeader,
    themeType: theme === 'dark' ? 'dark' : 'light',
    unsafeCSS,
  }), [resolvedThemeName, theme, diffStyle, disableBackground, disableFileHeader, unsafeCSS])

  // Call onReady after first render
  useEffect(() => {
    if (!hasCalledReady.current && onReady) {
      hasCalledReady.current = true
      // Give Shiki time to highlight
      const timer = setTimeout(() => {
        setIsReady(true)
        onReady()
      }, 100)
      return () => {
        clearTimeout(timer)
        hasCalledReady.current = false // Reset so re-mounts (including StrictMode) re-arm the timer
      }
    }
  }, [onReady, unifiedDiff, fileDiff])

  // Attach a click listener to the file header inside pierre's shadow DOM.
  const containerRef = useRef<HTMLDivElement>(null)
  const onFileHeaderClickRef = useRef(onFileHeaderClick)
  onFileHeaderClickRef.current = onFileHeaderClick

  useEffect(() => {
    if (!onFileHeaderClick || disableFileHeader) return

    // Wait briefly for pierre to render the header into the shadow DOM
    const timer = setTimeout(() => {
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (!header) return

      const handleClick = () => {
        onFileHeaderClickRef.current?.(filePath)
      }
      header.addEventListener('click', handleClick)
      // Store cleanup ref so we can remove listener
      ;(header as any).__craftClickCleanup = () => header.removeEventListener('click', handleClick)
    }, 150)

    return () => {
      clearTimeout(timer)
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (header) {
        ;(header as any).__craftClickCleanup?.()
      }
    }
  }, [filePath, disableFileHeader, onFileHeaderClick])

  // Use CSS variable so custom themes are respected
  const backgroundColor = 'var(--background)'

  // If we couldn't parse the diff, show a fallback
  if (!fileDiff) {
    return (
      <div
        ref={containerRef}
        className={cn(
          'h-full w-full overflow-auto p-4',
          className
        )}
        style={{
          backgroundColor,
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <pre className="text-foreground/70 whitespace-pre-wrap">{unifiedDiff || '(empty diff)'}</pre>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'h-full w-full overflow-auto transition-opacity duration-200',
        className
      )}
      style={{
        backgroundColor,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <FileDiff
        fileDiff={fileDiff}
        options={options}
        className="min-h-full h-full"
      />
    </div>
  )
}

/**
 * Calculate addition/deletion stats from a unified diff string.
 * Useful for displaying change counts in headers without full rendering.
 */
export function getUnifiedDiffStats(unifiedDiff: string, filePath: string = 'file'): { additions: number; deletions: number } | null {
  const fileDiff = parseUnifiedDiff(unifiedDiff, filePath)
  if (!fileDiff) return null

  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionCount
    deletions += hunk.deletionCount
  }
  return { additions, deletions }
}
