/**
 * ShikiCodeEditor - Editable code/markdown editor using react-simple-code-editor
 *
 * Replaces Monaco Editor for markdown editing with a lighter weight solution.
 * Uses textarea overlay technique with Shiki for syntax highlighting.
 *
 * Features:
 * - Syntax highlighting via Shiki
 * - Light/dark theme support
 * - Auto-indentation (tab key)
 * - Read-only mode support
 */

import * as React from 'react'
import { useState, useEffect, useCallback, useRef } from 'react'
import Editor from 'react-simple-code-editor'
import { codeToHtml, bundledLanguages, type BundledLanguage } from 'shiki'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'

export interface ShikiCodeEditorProps {
  /** The code/markdown content */
  value: string
  /** Language for syntax highlighting (default: 'markdown') */
  language?: string
  /** Callback when content changes */
  onChange?: (value: string) => void
  /** Whether the editor is read-only */
  readOnly?: boolean
  /** Callback when ready */
  onReady?: () => void
  /** Additional class names */
  className?: string
  /** Placeholder text when empty */
  placeholder?: string
}

// Map aliases to Shiki language names
const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  'md': 'markdown',
  'js': 'javascript',
  'ts': 'typescript',
}

function isValidLanguage(lang: string): lang is BundledLanguage {
  const normalized = LANGUAGE_ALIASES[lang] || lang
  return normalized in bundledLanguages
}

// Simple cache for highlighted code
const highlightCache = new Map<string, string>()
const CACHE_MAX_SIZE = 50

function getCacheKey(code: string, lang: string, theme: string): string {
  // Use hash for large content
  if (code.length > 500) {
    const hash = code.length.toString() + code.substring(0, 100) + code.substring(code.length - 100)
    return `${theme}:${lang}:${hash}`
  }
  return `${theme}:${lang}:${code}`
}

/**
 * ShikiCodeEditor - Lightweight syntax highlighted editor
 */
export function ShikiCodeEditor({
  value,
  language = 'markdown',
  onChange,
  readOnly = false,
  onReady,
  className,
  placeholder,
}: ShikiCodeEditorProps) {
  const { isDark, shikiTheme } = useTheme()
  const hasCalledReady = useRef(false)
  const [highlightedCode, setHighlightedCode] = useState<string>('')

  // Resolve language alias
  const resolvedLang = LANGUAGE_ALIASES[language.toLowerCase()] || language.toLowerCase()
  // Use the Shiki theme from the preset, falling back to github themes
  const theme = shikiTheme

  // Highlight function for the editor
  const highlight = useCallback(async (code: string): Promise<string> => {
    if (!code) return ''

    const cacheKey = getCacheKey(code, resolvedLang, theme)
    const cached = highlightCache.get(cacheKey)
    if (cached) return cached

    try {
      const lang = isValidLanguage(resolvedLang) ? resolvedLang : 'text'
      const html = await codeToHtml(code, { lang, theme })

      // Extract just the content inside <pre><code>...</code></pre>
      // Shiki returns: <pre class="..." style="..."><code>...</code></pre>
      const match = html.match(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/)
      const content = match ? match[1] : code

      // Cache the result
      if (highlightCache.size >= CACHE_MAX_SIZE) {
        const firstKey = highlightCache.keys().next().value
        if (firstKey) highlightCache.delete(firstKey)
      }
      highlightCache.set(cacheKey, content)

      return content
    } catch (error) {
      console.warn(`Shiki highlighting failed:`, error)
      return code
    }
  }, [resolvedLang, theme])

  // Initial highlight
  useEffect(() => {
    let cancelled = false

    async function doHighlight() {
      const result = await highlight(value)
      if (!cancelled) {
        setHighlightedCode(result)

        // Call onReady once
        if (!hasCalledReady.current && onReady) {
          hasCalledReady.current = true
          requestAnimationFrame(() => onReady())
        }
      }
    }

    doHighlight()

    return () => {
      cancelled = true
    }
  }, [value, highlight, onReady])

  // Handle change
  const handleValueChange = useCallback((newValue: string) => {
    if (!readOnly && onChange) {
      onChange(newValue)
    }
  }, [readOnly, onChange])

  // Synchronous highlight wrapper (for the editor component)
  // The editor needs a sync function, so we return cached or plain text
  const syncHighlight = useCallback((code: string): string => {
    const cacheKey = getCacheKey(code, resolvedLang, theme)
    const cached = highlightCache.get(cacheKey)
    if (cached) return cached

    // Trigger async highlight
    highlight(code).then(result => {
      if (result !== highlightedCode) {
        setHighlightedCode(result)
      }
    })

    // Return plain text or cached highlighted code for now
    return highlightedCode || code
  }, [resolvedLang, theme, highlight, highlightedCode])

  // Background color (must match CSS --background values)
  const backgroundColor = isDark ? '#302f33' : '#faf9fb'
  const textColor = isDark ? '#d4d4d4' : '#1f1f1f'
  const placeholderColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'

  return (
    <div
      className={cn('h-full w-full overflow-auto', className)}
      style={{ backgroundColor }}
    >
      <Editor
        value={value}
        onValueChange={handleValueChange}
        highlight={syncHighlight}
        disabled={readOnly}
        padding={24}
        placeholder={placeholder}
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 14,
          lineHeight: 1.6,
          minHeight: '100%',
          backgroundColor,
          color: textColor,
        }}
        textareaClassName={cn(
          'focus:outline-none',
          readOnly && 'cursor-default'
        )}
        className="min-h-full"
      />
      <style>{`
        .npm__react-simple-code-editor__textarea::placeholder {
          color: ${placeholderColor};
        }
      `}</style>
    </div>
  )
}
