/**
 * ShikiCodeViewer - Read-only code viewer using Shiki syntax highlighting
 *
 * Platform-agnostic component for displaying code with:
 * - Line numbers
 * - Syntax highlighting via Shiki
 * - Light/dark theme support
 * - Scrollable with custom scrollbar styling
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useRef } from 'react'
import { codeToHtml, bundledLanguages, type BundledLanguage } from 'shiki'
import { cn } from '../../lib/utils'
import { LANGUAGE_MAP } from './language-map'

export interface ShikiCodeViewerProps {
  /** The code content to display */
  code: string
  /** Language for syntax highlighting (auto-detected from filePath if not provided) */
  language?: string
  /** File path - used for language detection if language not specified */
  filePath?: string
  /** Starting line number (default: 1) */
  startLine?: number
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Shiki theme name (e.g., 'github-dark', 'dracula'). Defaults to github-dark/github-light based on theme mode */
  shikiTheme?: string
  /** Callback when ready */
  onReady?: () => void
  /** Additional class names */
  className?: string
}

// Map common extensions to Shiki language names
const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'sh': 'bash',
  'zsh': 'bash',
  'yml': 'yaml',
  'rb': 'ruby',
  'rs': 'rust',
  'kt': 'kotlin',
  'objective-c': 'objc',
  'objc': 'objc',
}

function isValidLanguage(lang: string): lang is BundledLanguage {
  const normalized = LANGUAGE_ALIASES[lang] || lang
  return normalized in bundledLanguages
}

function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_MAP[ext] || 'text'
}

/**
 * ShikiCodeViewer - Syntax highlighted code viewer with line numbers
 */
export function ShikiCodeViewer({
  code,
  language,
  filePath,
  startLine = 1,
  theme = 'light',
  shikiTheme,
  onReady,
  className,
}: ShikiCodeViewerProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const hasCalledReady = useRef(false)

  // Resolve language from props or file path
  const resolvedLang = useMemo(() => {
    const lang = language || (filePath ? getLanguageFromPath(filePath) : 'text')
    const lowered = lang.toLowerCase()
    return LANGUAGE_ALIASES[lowered] || lowered
  }, [language, filePath])

  // Split code into lines for line numbers
  const lines = useMemo(() => code.split('\n'), [code])

  // Highlight code with Shiki
  useEffect(() => {
    let cancelled = false

    async function highlight() {
      // Use provided shikiTheme or fall back to github theme based on mode
      const resolvedShikiTheme = shikiTheme || (theme === 'dark' ? 'github-dark' : 'github-light')
      const lang = isValidLanguage(resolvedLang) ? resolvedLang : 'text'

      try {
        const html = await codeToHtml(code, {
          lang,
          theme: resolvedShikiTheme,
        })

        if (!cancelled) {
          setHighlighted(html)
          setIsLoading(false)

          // Call onReady once
          if (!hasCalledReady.current && onReady) {
            hasCalledReady.current = true
            requestAnimationFrame(() => onReady())
          }
        }
      } catch (error) {
        console.warn(`Shiki highlighting failed for language "${resolvedLang}":`, error)
        if (!cancelled) {
          setHighlighted(null)
          setIsLoading(false)

          if (!hasCalledReady.current && onReady) {
            hasCalledReady.current = true
            requestAnimationFrame(() => onReady())
          }
        }
      }
    }

    highlight()

    return () => {
      cancelled = true
    }
  }, [code, resolvedLang, theme, shikiTheme, onReady])

  // Use CSS variables so custom themes are respected
  const backgroundColor = 'var(--background)'
  const lineNumberColor = theme === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'
  const borderColor = theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'

  return (
    <div
      className={cn('h-full w-full overflow-auto', className)}
      style={{ backgroundColor }}
    >
      <div className="min-h-full flex">
        {/* Line numbers gutter */}
        <div
          className="sticky left-0 shrink-0 select-none text-right pr-4 pt-4 pb-4"
          style={{
            backgroundColor,
            borderRight: `1px solid ${borderColor}`,
            minWidth: '60px',
          }}
        >
          {lines.map((_, index) => (
            <div
              key={index}
              className="font-mono text-[13px] leading-[1.6] px-2"
              style={{ color: lineNumberColor }}
            >
              {startLine + index}
            </div>
          ))}
        </div>

        {/* Code content */}
        <div className="flex-1 min-w-0 p-4 overflow-x-auto">
          {isLoading || !highlighted ? (
            <pre className="font-mono text-[13px] leading-[1.6] whitespace-pre">
              <code>{code}</code>
            </pre>
          ) : (
            <div
              className={cn(
                'font-mono text-[13px] leading-[1.6]',
                '[&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:whitespace-pre',
                '[&_code]:!bg-transparent'
              )}
              style={{ fontFamily: '"JetBrains Mono", monospace' }}
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
