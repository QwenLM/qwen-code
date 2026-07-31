import * as React from 'react'
import katex from 'katex'
import { cn } from '../../lib/utils'

interface MarkdownLatexBlockProps {
  code: string
  className?: string
}

/**
 * MarkdownLatexBlock - Renders fenced ```latex / ```math code blocks as display math.
 *
 * Uses KaTeX to render LaTeX source into styled HTML.
 * On parse errors, shows the raw source with an error message.
 */
export function MarkdownLatexBlock({ code, className }: MarkdownLatexBlockProps) {
  const html = React.useMemo(() => {
    try {
      return katex.renderToString(code.trim(), {
        displayMode: true,
        throwOnError: false,
        strict: false,
      })
    } catch {
      return null
    }
  }, [code])

  if (!html) {
    return (
      <pre className={cn('font-mono text-sm whitespace-pre-wrap text-destructive', className)}>
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <div
      className={cn('overflow-x-auto py-2', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
