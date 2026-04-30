import * as React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { cn } from '../../lib/utils'
import { CodeBlock, InlineCode } from './CodeBlock'
import { MarkdownDiffBlock } from './MarkdownDiffBlock'
import { MarkdownJsonBlock } from './MarkdownJsonBlock'
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock'
import { MarkdownDatatableBlock } from './MarkdownDatatableBlock'
import { MarkdownSpreadsheetBlock } from './MarkdownSpreadsheetBlock'
import { MarkdownHtmlBlock } from './MarkdownHtmlBlock'
import { MarkdownImageBlock } from './MarkdownImageBlock'
import { MarkdownLatexBlock } from './MarkdownLatexBlock'
import { MarkdownPdfBlock } from './MarkdownPdfBlock'
import { preprocessLinks } from './linkify'
import { resolveMarkdownLinkTarget } from './link-target'
import remarkCollapsibleSections from './remarkCollapsibleSections'
import { CollapsibleSection } from './CollapsibleSection'
import { useCollapsibleMarkdown } from './CollapsibleMarkdownContext'
import { wrapWithSafeProxy } from './safe-components'
import { MARKDOWN_MATH_OPTIONS } from './math-options'

/**
 * Render modes for markdown content:
 *
 * - 'terminal': Raw output with minimal formatting, control chars visible
 *   Best for: Debug output, raw logs, when you want to see exactly what's there
 *
 * - 'minimal': Clean rendering with syntax highlighting but no extra chrome
 *   Best for: Chat messages, inline content, when you want readability without clutter
 *
 * - 'full': Rich rendering with beautiful tables, styled code blocks, proper typography
 *   Best for: Documentation, long-form content, when presentation matters
 */
export type RenderMode = 'terminal' | 'minimal' | 'full'

export interface MarkdownProps {
  children: string
  /**
   * Render mode controlling formatting level
   * @default 'minimal'
   */
  mode?: RenderMode
  className?: string
  /**
   * Message ID for memoization (optional)
   * When provided, memoizes parsed blocks to avoid re-parsing during streaming
   */
  id?: string
  /**
   * Callback when a URL is clicked
   */
  onUrlClick?: (url: string) => void
  /**
   * Callback when a file path is clicked
   */
  onFileClick?: (path: string) => void
  /**
   * Enable collapsible headings
   * Requires wrapping in CollapsibleMarkdownProvider
   * @default false
   */
  collapsible?: boolean
  /**
   * Hide expand button on first mermaid block (when message starts with mermaid)
   * Used in chat to avoid overlap with TurnCard's fullscreen button
   * @default true
   */
  hideFirstMermaidExpand?: boolean
}

/** Context for collapsible sections */
interface CollapsibleContext {
  collapsedSections: Set<string>
  toggleSection: (id: string) => void
}

/**
 * Create custom components based on render mode.
 *
 * @param firstMermaidCodeRef - Ref holding the code of the first mermaid block
 *   when the markdown message starts with a mermaid fence. Used to hide the
 *   inline expand button on that block (TurnCard's own fullscreen button
 *   occupies the same top-right position). A ref is used so the closure can
 *   read the latest value without adding content to the memo deps — that would
 *   cause component re-mounting on every streaming update.
 * @param hideFirstMermaidExpand - Whether to hide the expand button on the first
 *   mermaid block when the message starts with a mermaid fence. Defaults to true.
 */
function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function createComponents(
  mode: RenderMode,
  onUrlClick?: (url: string) => void,
  onFileClick?: (path: string) => void,
  collapsibleContext?: CollapsibleContext | null,
  firstMermaidCodeRef?: React.RefObject<string | null>,
  hideFirstMermaidExpand: boolean = true
): Partial<Components> {
  let blockIndex = 0
  const wrapBlock = (
    blockType: string,
    content: string,
    child: React.ReactNode,
    nodePosition?: { start?: { line?: number }; end?: { line?: number } },
  ) => {
    blockIndex += 1
    const startLine = nodePosition?.start?.line
    const endLine = nodePosition?.end?.line
    const path = startLine && endLine
      ? `line:${startLine}-${endLine}`
      : `idx:${blockIndex}`
    const blockId = `blk-${stableHash(`${blockType}|${path}|${content.slice(0, 240)}`)}`

    return (
      <div
        data-ca-block-type={blockType}
        data-ca-block-path={path}
        data-ca-block-id={blockId}
      >
        {child}
      </div>
    )
  }

  const baseComponents: Partial<Components> = {
    // Section wrapper for collapsible headings
    div: ({ node, children, ...props }) => {
      const sectionId = (props as Record<string, unknown>)['data-section-id'] as string | undefined
      const headingLevel = (props as Record<string, unknown>)['data-heading-level'] as number | undefined

      // If this is a collapsible section div and we have context
      if (sectionId && headingLevel && collapsibleContext) {
        return (
          <CollapsibleSection
            sectionId={sectionId}
            headingLevel={headingLevel}
            isCollapsed={collapsibleContext.collapsedSections.has(sectionId)}
            onToggle={collapsibleContext.toggleSection}
          >
            {children}
          </CollapsibleSection>
        )
      }

      // Regular div
      return <div {...props}>{children}</div>
    },
    // Links: Make clickable with callbacks
    a: ({ href, children }) => {
      const handleClick = (e: React.MouseEvent) => {
        e.preventDefault()

        // Some AI outputs include raw HTML anchors with empty href but path text content.
        // Fallback to the anchor text when href is missing/empty.
        const fallbackText = React.Children.toArray(children)
          .map((child) => (typeof child === 'string' ? child : ''))
          .join('')
          .trim()

        const target = (href?.trim() || fallbackText)
        if (!target) return

        const resolvedTarget = resolveMarkdownLinkTarget(target)
        if (resolvedTarget.kind === 'file' && onFileClick) {
          onFileClick(resolvedTarget.path)
        } else if (resolvedTarget.kind === 'url' && onUrlClick) {
          onUrlClick(resolvedTarget.url)
        }
      }

      return (
        <a
          href={href}
          onClick={handleClick}
          className="text-accent hover:underline cursor-pointer"
        >
          {children}
        </a>
      )
    },
  }

  // Terminal mode: minimal formatting
  if (mode === 'terminal') {
    return {
      ...baseComponents,
      // No special code handling - just monospace
      code: ({ children }) => (
        <code className="font-mono">{children}</code>
      ),
      pre: ({ children }) => (
        <pre className="font-mono whitespace-pre-wrap my-2">{children}</pre>
      ),
      // Minimal paragraph spacing
      p: ({ children }) => <p className="my-1">{children}</p>,
      // Simple lists
      ul: ({ children }) => <ul className="list-disc list-inside my-1">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal list-inside my-1">{children}</ol>,
      li: ({ children }) => <li className="my-0.5">{children}</li>,
      // Plain tables
      table: ({ children }) => (
        <table className="my-2 font-mono text-sm">{children}</table>
      ),
      th: ({ children }) => <th className="text-left pr-4">{children}</th>,
      td: ({ children }) => <td className="pr-4">{children}</td>,
    }
  }

  // Minimal mode: clean with syntax highlighting
  if (mode === 'minimal') {
    return {
      ...baseComponents,
      // Inline code
      code: ({ className, children, ...props }) => {
        const match = /language-([\w-]+)/.exec(className || '')
        const isBlock = 'node' in props && props.node?.position?.start.line !== props.node?.position?.end.line

        // Block code
        if (match || isBlock) {
          const code = String(children).replace(/\n$/, '')
          // Diff code blocks → pierre/diffs for a proper diff viewer
          if (match?.[1] === 'diff') {
            return wrapBlock('code', code, <MarkdownDiffBlock code={code} className="my-2" />, props.node?.position)
          }
          // JSON code blocks → interactive tree viewer
          if (match?.[1] === 'json') {
            return wrapBlock('code', code, <MarkdownJsonBlock code={code} className="my-2" />, props.node?.position)
          }
          // Datatable code blocks → sortable/filterable data table
          if (match?.[1] === 'datatable') {
            return wrapBlock('datatable', code, <MarkdownDatatableBlock code={code} className="my-2" />, props.node?.position)
          }
          // Spreadsheet code blocks → Excel-style grid
          if (match?.[1] === 'spreadsheet') {
            return wrapBlock('spreadsheet', code, <MarkdownSpreadsheetBlock code={code} className="my-2" />, props.node?.position)
          }
          // HTML preview blocks → sandboxed iframe
          if (match?.[1] === 'html-preview') {
            return wrapBlock('html-preview', code, <MarkdownHtmlBlock code={code} className="my-2" />, props.node?.position)
          }
          // PDF preview blocks → inline first page with expand to full viewer
          if (match?.[1] === 'pdf-preview') {
            return wrapBlock('pdf-preview', code, <MarkdownPdfBlock code={code} className="my-2" />, props.node?.position)
          }
          // Image preview blocks → inline image with expand to full viewer
          if (match?.[1] === 'image-preview') {
            return wrapBlock('image-preview', code, <MarkdownImageBlock code={code} className="my-2" />, props.node?.position)
          }
          // LaTeX/math code blocks → KaTeX rendered display math
          if (match?.[1] === 'latex' || match?.[1] === 'math') {
            return wrapBlock('latex', code, <MarkdownLatexBlock code={code} className="my-2" />, props.node?.position)
          }
          // Mermaid code blocks → zinc-styled SVG diagram.
          // Hide the inline expand button when the mermaid block is the first
          // content in the message — TurnCard's own fullscreen button occupies
          // the same top-right spot. Detection uses firstMermaidCodeRef (content
          // match) rather than AST line positions which are unreliable after
          // preprocessLinks transforms the markdown.
          if (match?.[1] === 'mermaid') {
            const isFirstBlock = hideFirstMermaidExpand &&
                                firstMermaidCodeRef?.current != null &&
                                code === firstMermaidCodeRef.current
            return wrapBlock(
              'mermaid',
              code,
              <MarkdownMermaidBlock code={code} className="my-2" showExpandButton={!isFirstBlock} />,
              props.node?.position,
            )
          }
          return wrapBlock('code', code, <CodeBlock code={code} language={match?.[1]} mode="full" className="my-2" />, props.node?.position)
        }

        // Inline code
        return <InlineCode>{children}</InlineCode>
      },
      pre: ({ children }) => <>{children}</>,
      // Comfortable paragraph spacing
      p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
      // Styled lists - ul uses tighter spacing, ol uses standard for number alignment
      ul: ({ children, className }) => (
        <ul
          className={cn(
            'my-2 space-y-1 ps-[16px] pe-2 list-disc marker:text-[var(--md-bullets)]',
            className?.includes('contains-task-list') && 'list-none ps-0 marker:content-none',
          )}
        >
          {children}
        </ul>
      ),
      ol: ({ children, className }) => (
        <ol className={cn('my-2 space-y-1 pl-6 list-decimal', className)}>{children}</ol>
      ),
      li: ({ children, className }) => (
        <li className={cn(className?.includes('task-list-item') && 'list-none')}>{children}</li>
      ),
      input: ({ type, checked }) => {
        if (type === 'checkbox') {
          return (
            <input
              type="checkbox"
              checked={checked}
              readOnly
              className="mr-2 rounded border-muted-foreground align-middle"
            />
          )
        }
        return <input type={type} />
      },
      // Clean tables
      table: ({ children }) => (
        <div className="my-3 overflow-x-auto">
          <table className="min-w-full text-sm">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="border-b">{children}</thead>,
      th: ({ children }) => (
        <th className="text-left py-2 px-3 font-semibold text-muted-foreground">{children}</th>
      ),
      td: ({ children }) => (
        <td className="py-2 px-3 border-b border-border/50">{children}</td>
      ),
      // Headings - H1/H2 same size, differentiated by weight
      h1: ({ children }) => <h1 className="font-sans text-[16px] font-bold mt-5 mb-3">{children}</h1>,
      h2: ({ children }) => <h2 className="font-sans text-[16px] font-semibold mt-4 mb-3">{children}</h2>,
      h3: ({ children }) => <h3 className="font-sans text-[15px] font-semibold mt-4 mb-2">{children}</h3>,
      // Blockquotes
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">
          {children}
        </blockquote>
      ),
      // Horizontal rules
      hr: () => <hr className="my-4 border-border" />,
      // Strong/emphasis
      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
      em: ({ children }) => <em className="italic">{children}</em>,
    }
  }

  // Full mode: rich styling
  return {
    ...baseComponents,
    // Full code blocks with copy button
    code: ({ className, children, ...props }) => {
      const match = /language-([\w-]+)/.exec(className || '')
      const isBlock = 'node' in props && props.node?.position?.start.line !== props.node?.position?.end.line

      if (match || isBlock) {
        const code = String(children).replace(/\n$/, '')
        // Diff code blocks → pierre/diffs for a proper diff viewer
        if (match?.[1] === 'diff') {
          return wrapBlock('code', code, <MarkdownDiffBlock code={code} className="my-2" />, props.node?.position)
        }
        // JSON code blocks → interactive tree viewer
        if (match?.[1] === 'json') {
          return wrapBlock('code', code, <MarkdownJsonBlock code={code} className="my-2" />, props.node?.position)
        }
        // Datatable code blocks → sortable/filterable data table
        if (match?.[1] === 'datatable') {
          return wrapBlock('datatable', code, <MarkdownDatatableBlock code={code} className="my-2" />, props.node?.position)
        }
        // Spreadsheet code blocks → Excel-style grid
        if (match?.[1] === 'spreadsheet') {
          return wrapBlock('spreadsheet', code, <MarkdownSpreadsheetBlock code={code} className="my-2" />, props.node?.position)
        }
        // HTML preview blocks → sandboxed iframe
        if (match?.[1] === 'html-preview') {
          return wrapBlock('html-preview', code, <MarkdownHtmlBlock code={code} className="my-2" />, props.node?.position)
        }
        // PDF preview blocks → inline first page with expand to full viewer
        if (match?.[1] === 'pdf-preview') {
          return wrapBlock('pdf-preview', code, <MarkdownPdfBlock code={code} className="my-2" />, props.node?.position)
        }
        // Image preview blocks → inline image with expand to full viewer
        if (match?.[1] === 'image-preview') {
          return wrapBlock('image-preview', code, <MarkdownImageBlock code={code} className="my-2" />, props.node?.position)
        }
        // LaTeX/math code blocks → KaTeX rendered display math
        if (match?.[1] === 'latex' || match?.[1] === 'math') {
          return wrapBlock('latex', code, <MarkdownLatexBlock code={code} className="my-2" />, props.node?.position)
        }
        // Mermaid code blocks → zinc-styled SVG diagram.
        // (Same first-block detection as minimal mode — see comment above.)
        if (match?.[1] === 'mermaid') {
          const isFirstBlock = hideFirstMermaidExpand &&
                              firstMermaidCodeRef?.current != null &&
                              code === firstMermaidCodeRef.current
          return wrapBlock(
            'mermaid',
            code,
            <MarkdownMermaidBlock code={code} className="my-2" showExpandButton={!isFirstBlock} />,
            props.node?.position,
          )
        }
        return wrapBlock('code', code, <CodeBlock code={code} language={match?.[1]} mode="full" className="my-2" />, props.node?.position)
      }

      return <InlineCode>{children}</InlineCode>
    },
    pre: ({ children }) => <>{children}</>,
    // Rich paragraph spacing
    p: ({ children }) => <p className="my-3 leading-relaxed">{children}</p>,
    // Styled lists - ul uses tighter spacing, ol uses standard for number alignment
    ul: ({ children, className }) => (
      <ul
        className={cn(
          'my-3 space-y-1.5 ps-[16px] pe-2 list-disc marker:text-[var(--md-bullets)]',
          className?.includes('contains-task-list') && 'list-none ps-0 marker:content-none',
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ children, className }) => (
      <ol className={cn('my-3 space-y-1.5 pl-6 list-decimal', className)}>{children}</ol>
    ),
    li: ({ children, className }) => (
      <li className={cn('leading-relaxed', className?.includes('task-list-item') && 'list-none')}>{children}</li>
    ),
    // Beautiful tables
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y divide-border">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-border">{children}</tbody>,
    th: ({ children }) => (
      <th className="text-left py-3 px-4 font-semibold text-sm">{children}</th>
    ),
    td: ({ children }) => (
      <td className="py-3 px-4 text-sm">{children}</td>
    ),
    tr: ({ children }) => (
      <tr className="hover:bg-muted/30 transition-colors">{children}</tr>
    ),
    // Rich headings - H1/H2 same size, differentiated by weight
    h1: ({ children }) => (
      <h1 className="font-sans text-[16px] font-bold mt-7 mb-4">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="font-sans text-[16px] font-semibold mt-6 mb-3">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-sans text-[15px] font-semibold mt-5 mb-3">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-[14px] font-semibold mt-3 mb-1">{children}</h4>
    ),
    // Styled blockquotes
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-foreground/30 bg-muted/30 pl-4 pr-3 py-2 my-3 rounded-r-md">
        {children}
      </blockquote>
    ),
    // Task lists (GFM)
    input: ({ type, checked }) => {
      if (type === 'checkbox') {
        return (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="mr-2 rounded border-muted-foreground"
          />
        )
      }
      return <input type={type} />
    },
    // Horizontal rules
    hr: () => <hr className="my-6 border-border" />,
    // Strong/emphasis
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through text-muted-foreground">{children}</del>,
    // Handle unknown <markdown> tags that may come through rehype-raw
    // Type assertion needed because 'markdown' is not a standard HTML element
    markdown: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  } as Partial<Components>
}

/**
 * Markdown - Customizable markdown renderer with multiple render modes
 *
 * Features:
 * - Three render modes: terminal, minimal, full
 * - Syntax highlighting via Shiki
 * - GFM support (tables, task lists, strikethrough)
 * - Clickable links and file paths
 * - Memoization for streaming performance
 */
export function Markdown({
  children,
  mode = 'minimal',
  className,
  id,
  onUrlClick,
  onFileClick,
  collapsible = false,
  hideFirstMermaidExpand = true,
}: MarkdownProps) {
  // Get collapsible context if enabled
  const collapsibleContext = useCollapsibleMarkdown()

  // Extract the first mermaid code block's content when the message starts
  // with a mermaid fence. Stored in a ref so createComponents can read it
  // without adding `children` to the memo deps (which would remount all
  // components on every streaming update, breaking internal state).
  const firstMermaidCodeRef = React.useRef<string | null>(null)
  const trimmed = children.trimStart()
  if (trimmed.startsWith('```mermaid')) {
    const m = trimmed.match(/^```mermaid\n([\s\S]*?)```/)
    firstMermaidCodeRef.current = m?.[1] ? m[1].replace(/\n$/, '') : null
  } else {
    firstMermaidCodeRef.current = null
  }

  const components = React.useMemo(
    () => wrapWithSafeProxy(createComponents(mode, onUrlClick, onFileClick, collapsible ? collapsibleContext : null, firstMermaidCodeRef, hideFirstMermaidExpand)),
    [mode, onUrlClick, onFileClick, collapsible, collapsibleContext, hideFirstMermaidExpand]
  )

  // Preprocess to convert raw URLs and file paths to markdown links
  const processedContent = React.useMemo(
    () => preprocessLinks(children),
    [children]
  )

  // Conditionally include the collapsible sections plugin.
  // IMPORTANT: Disable single-dollar inline math so currency like $2M–$4M
  // stays plain text. Math should use $$...$$ delimiters.
  const remarkPlugins = React.useMemo(
    () => {
      const mathPlugin: [typeof remarkMath, typeof MARKDOWN_MATH_OPTIONS] = [
        remarkMath,
        MARKDOWN_MATH_OPTIONS
      ]
      return collapsible
        ? [remarkGfm, mathPlugin, remarkCollapsibleSections]
        : [remarkGfm, mathPlugin]
    },
    [collapsible]
  )

  return (
    <div className={cn('markdown-content', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex, rehypeRaw]}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  )
}

/**
 * MemoizedMarkdown - Optimized for streaming scenarios
 *
 * Splits content into blocks and memoizes each block separately,
 * so only new/changed blocks re-render during streaming.
 */
export const MemoizedMarkdown = React.memo(
  Markdown,
  (prevProps, nextProps) => {
    // If id is provided, use it for memoization
    if (prevProps.id && nextProps.id) {
      return (
        prevProps.id === nextProps.id &&
        prevProps.children === nextProps.children &&
        prevProps.mode === nextProps.mode
      )
    }
    // Otherwise compare content and mode
    return (
      prevProps.children === nextProps.children &&
      prevProps.mode === nextProps.mode
    )
  }
)
MemoizedMarkdown.displayName = 'MemoizedMarkdown'

// Re-export for convenience
export { CodeBlock, InlineCode } from './CodeBlock'
export { CollapsibleMarkdownProvider } from './CollapsibleMarkdownContext'
